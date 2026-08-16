import satori from 'satori'
import fs from 'fs'
import { Resvg } from '@resvg/resvg-js'
import dayjs from 'dayjs'
import { platformArticleMapToActionText } from '@kyestu/spider/const'
import type { Article } from './types'
import { ImgConverter, loadDynamicAsset } from './img'
import {
    articleParser,
    BASE_FONT_SIZE,
    BaseCard,
    CARD_WIDTH,
    CONTENT_WIDTH,
    estimateImagesHeight,
    estimateTextLinesHeight,
} from '../template/img/DefaultCard'
import tailwindConfig from '../template/img/DefaultTailwindConfig'

const article = {
    id: 3015,
    platform: 2,
    a_id: 'DIfu4VdSU3s',
    u_id: 'nirei_nozomi_official',
    username: '楡井希実',
    created_at: 1744781517,
    content:
        'ふうと双子コーデでディズニー🏰\n\n小さい頃に映画を観て大好きになったランピーをだっこしながら周りました•͈౿•͈⟡.*\nスプラッシュマウンテンの水しぶきからも無事守った…！\n\n一緒にお洋服を選んでる時からずーーっと楽しくて、当日もいっぱいエスコートしてくれたふう💚ありがとう！！\n#ディズニー #disney',
    translation:
        '和ふう穿双胞胎装扮去了迪士尼🏰\n\n抱着小时候看了电影后就非常喜欢的小豆，到处逛了一圈•͈౿•͈⟡.*\n也成功地从小飞溅山的水花中保护了它…！\n\n从一起选衣服的时候开始就一直很开心，当天ふう也为我做了很多引导💚谢谢！！\n#迪士尼 #disney\n',
    translated_by: 'Gemini 2.0 Flash',
    url: 'https://www.instagram.com/p/DIfu4VdSU3s/',
    type: 'post',
    ref: null,
    has_media: true,
    media: [
        {
            type: 'photo',
            url: 'https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/491465311_17864709675372956_2237267671724312457_n.jpg?stp=dst-jpg_e35_s240x240_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6IkNBUk9VU0VMX0lURU0uaW1hZ2VfdXJsZ2VuLjE0NDB4MTQ0MC5zZHIuZjc1NzYxLmRlZmF1bHRfaW1hZ2UifQ&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=108&_nc_oc=Q6cZ2QHIlGfuvwZZOn-gmrg5tWtHiY5XZdHX2njiniZKtJmiPPxYZKjT97_R5n48n8uPE5oFPc4lTZUxbBjmAQ9O69wa&_nc_ohc=I9MobmiVnXUQ7kNvwG9b68p&_nc_gid=Cg7t742vIh9RHXhwMFuPoA&edm=AP4sbd4BAAAA&ccb=7-5&ig_cache_key=MzYxMTgxMTU5ODA5ODMwMTY5OQ%3D%3D.3-ccb7-5&oh=00_AfFrKpvJhwvxpVNqoaBQvSq7wLNZMaWnM-GnsC_4bcbSAA&oe=680536EE&_nc_sid=7a9f4b',
        },
        {
            type: 'photo',
            url: 'https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/490476273_17864709684372956_6796217402475158635_n.jpg?stp=dst-jpegr_e35_s240x240_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6IkNBUk9VU0VMX0lURU0uaW1hZ2VfdXJsZ2VuLjE0NDB4MTQ0MC5oZHIuZjc1NzYxLmRlZmF1bHRfaW1hZ2UifQ&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=108&_nc_oc=Q6cZ2QHIlGfuvwZZOn-gmrg5tWtHiY5XZdHX2njiniZKtJmiPPxYZKjT97_R5n48n8uPE5oFPc4lTZUxbBjmAQ9O69wa&_nc_ohc=7zAaMPu6l8QQ7kNvwHNVgcy&_nc_gid=Cg7t742vIh9RHXhwMFuPoA&edm=AP4sbd4BAAAA&ccb=7-5&ig_cache_key=MzYxMTgxMTU5ODA5ODM4MjQ0Mg%3D%3D.3-ccb7-5&oh=00_AfHDhzUKvsepYhF1SQQ9X8ebvX-S3j2pecVWNuLu9Fsclw&oe=68052C57&_nc_sid=7a9f4b',
        },
        {
            type: 'photo',
            url: 'https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/491465754_17864709693372956_1238852204136515533_n.jpg?stp=dst-jpg_e35_s240x240_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6IkNBUk9VU0VMX0lURU0uaW1hZ2VfdXJsZ2VuLjExMDh4MTEwOC5zZHIuZjc1NzYxLmRlZmF1bHRfaW1hZ2UifQ&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=108&_nc_oc=Q6cZ2QHIlGfuvwZZOn-gmrg5tWtHiY5XZdHX2njiniZKtJmiPPxYZKjT97_R5n48n8uPE5oFPc4lTZUxbBjmAQ9O69wa&_nc_ohc=hrThE5YtHykQ7kNvwEgYZ-U&_nc_gid=Cg7t742vIh9RHXhwMFuPoA&edm=AP4sbd4BAAAA&ccb=7-5&ig_cache_key=MzYxMTgxMTU5ODA4MTU5MjQ4OA%3D%3D.3-ccb7-5&oh=00_AfHl7ow3G8c7Lp29ZwaoYh1L0TyG9DErsvE3kqAzO9qQYg&oe=68055A18&_nc_sid=7a9f4b',
        },
    ],
    extra: null,
    u_avatar:
        'https://scontent-lax3-2.cdninstagram.com/v/t51.2885-19/487423402_560484120385081_1071923922631827984_n.jpg?_nc_ht=scontent-lax3-2.cdninstagram.com&_nc_cat=101&_nc_oc=Q6cZ2QHIlGfuvwZZOn-gmrg5tWtHiY5XZdHX2njiniZKtJmiPPxYZKjT97_R5n48n8uPE5oFPc4lTZUxbBjmAQ9O69wa&_nc_ohc=P-kZh6KRiJsQ7kNvwHL5elc&_nc_gid=Cg7t742vIh9RHXhwMFuPoA&edm=AP4sbd4BAAAA&ccb=7-5&oh=00_AfHLtm6UuqALsO-yRBLbR3Jld9xr0vq1BGoT2rg_B-CeMA&oe=68054664&_nc_sid=7a9f4b',
} as Article

async function main() {
    const imgConverter = new ImgConverter()
    const imageBuffer = await imgConverter.articleToImg(article, '../../assets/fonts')
    fs.writeFileSync('./output.png', imageBuffer)
}
main()
